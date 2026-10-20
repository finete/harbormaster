// Pure view-model logic for the workspace sidebar (Sidebar.tsx): repository
// grouping, search filtering, board-position chip labels, PR links, and
// compact relative times. Kept free of React and of `window` so it is
// unit-testable under plain vitest (see packages/app/tests/sidebar-model.test.ts).
//
// Rail order is FIXED and USER-OWNED (ai/prds/sidebar-ordering.md, R1): rows
// sort by their index in the persisted global task order and groups by the
// persisted group order (lib/sidebar-order.ts). Nothing here ever reorders
// by activity (running/live), board column, or core push; ids/labels the
// stored order doesn't know yet sort after the known ones (new ones land at
// the bottom). Only an explicit drag rewrites the stored order.
import type {
  BoardColumn,
  PresenceBadge,
  Task,
  TaskState,
} from "../../../preload/api";
import { sortByOrder } from "../lib/sidebar-order";
import { lastInteractionTimestamp, relativeTime } from "../lib/time-format";

export { relativeTime };

/** Group label for repository-less (scratch) tasks; always sorted last. */
export const SCRATCH_GROUP = "scratch";

/** One sidebar row: a task, its board column, and its live presence (if any). */
export interface SidebarRow {
  task: Task;
  state: TaskState;
  presence: PresenceBadge | undefined;
}

/** One collapsible repository section of the sidebar. */
export interface SidebarGroup {
  /** Short repository name (last path segment) or {@link SCRATCH_GROUP}. */
  label: string;
  rows: SidebarRow[];
}

/** Short repository name ("github.com/org/repo" -> "repo"), or "scratch". */
export function repoLabel(task: Pick<Task, "repositoryId">): string {
  const id = task.repositoryId?.trim();
  if (!id) return SCRATCH_GROUP;
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? id;
}

/**
 * Every *opened* task on the board, in `openedTaskIds` insertion order — NOT
 * board order, so a column move or any core push can never reshuffle the rail
 * (R1/R3); the stored task order is applied afterwards by `groupRows`. The
 * rail lists open task workspaces, cmux-style, not the full board inventory
 * (`openedTaskIds` is App's `openedTaskIds` state) — the Board stays the
 * full inventory, see App.tsx / docs/design-decisions.md.
 */
export function sidebarRows(
  columns: BoardColumn[],
  presence: Record<string, PresenceBadge | undefined>,
  openedTaskIds: ReadonlySet<string>,
): SidebarRow[] {
  const byId = new Map<string, { task: Task; state: TaskState }>();
  for (const column of columns) {
    for (const group of column.groups) {
      for (const task of group.tasks) {
        byId.set(task.id, { task, state: column.state });
      }
    }
  }
  const rows: SidebarRow[] = [];
  // An open workspace always gets a row (cmux rule: every open window is
  // listed), even an archived task, or it becomes an orphan pane with no way
  // to see or close it from the rail.
  for (const id of openedTaskIds) {
    const hit = byId.get(id);
    if (hit) rows.push({ ...hit, presence: presence[id] });
  }
  return rows;
}

/** Case-insensitive substring match over title, branch, and repository. */
export function matchesQuery(row: SidebarRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    row.task.title,
    row.task.branch ?? "",
    row.task.repositoryId ?? "",
    repoLabel(row.task),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Groups rows by short repository name. Groups sort by their index in
 * `groupOrder` (R5); labels it doesn't list come after, in the default order
 * (alphabetical, "scratch" last). Within a group rows sort by their index in
 * `taskOrder` (R2); unknown ids come after, in input order. No activity sort.
 */
export function groupRows(
  rows: SidebarRow[],
  taskOrder: readonly string[] = [],
  groupOrder: readonly string[] = [],
): SidebarGroup[] {
  const byLabel = new Map<string, SidebarRow[]>();
  for (const row of rows) {
    const label = repoLabel(row.task);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(row);
    else byLabel.set(label, [row]);
  }
  const defaultLabels = [...byLabel.keys()].sort((a, b) => {
    if (a === SCRATCH_GROUP) return b === SCRATCH_GROUP ? 0 : 1;
    if (b === SCRATCH_GROUP) return -1;
    return a.localeCompare(b);
  });
  const labels = sortByOrder(defaultLabels, groupOrder, (label) => label);
  return labels.map((label) => ({
    label,
    rows: sortByOrder(
      byLabel.get(label) ?? [],
      taskOrder,
      (row) => row.task.id,
    ),
  }));
}

/** Visual tone of a state chip; mirrors the board's per-column colors. */
export type StateTone = "backlog" | "dev" | "awaiting" | "done";

/**
 * Board-position chip text: the column name, or for awaiting tasks the
 * specific reason ("Review", "Slack") / deploy stage label.
 */
export function stateChipLabel(task: Task, state: TaskState): string {
  switch (state) {
    case "backlog":
      return "Backlog";
    case "dev":
      return "Dev";
    case "done":
      return "Done";
    case "awaiting": {
      const awaiting = task.awaiting;
      if (!awaiting) return "Awaiting";
      if (awaiting.kind === "review") return "Review";
      if (awaiting.kind === "slack") return "Slack";
      return awaiting.stageLabel || "Deploy";
    }
  }
}

/**
 * The PR's GitHub page: the URL gh reported (refreshed into `task.pr.url`),
 * else one derived from a github.com repository id. Undefined when neither
 * is available — the chip then renders but cannot open anything.
 */
export function pullRequestUrl(task: Task): string | undefined {
  const pr = task.pr;
  if (!pr) return undefined;
  if (pr.url) return pr.url;
  const id = task.repositoryId;
  if (id?.startsWith("github.com/") && id.split("/").length >= 3) {
    return `https://${id}/pull/${pr.number}`;
  }
  return undefined;
}

/** The timestamp the relative-time column shows: live heartbeat, else last task update. */
export function activityTimestamp(row: SidebarRow): string {
  return lastInteractionTimestamp(row.task, row.presence);
}

/** Sidebar width bounds (px) for drag-resize; persisted widths are clamped into range. */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 280;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

/**
 * Splits `groups` into a "Pinned" section (Orca polish item 3) and the
 * remaining repo groups with pinned rows removed, so a pinned task never
 * renders twice. Pinned rows follow the global `taskOrder` (R28), not
 * board order or insertion-into-`pinnedIds` order, so re-pinning doesn't
 * reshuffle the section.
 */
export function partitionPinned(
  groups: SidebarGroup[],
  pinnedIds: ReadonlySet<string>,
  taskOrder: readonly string[] = [],
): { pinned: SidebarRow[]; rest: SidebarGroup[] } {
  if (pinnedIds.size === 0) return { pinned: [], rest: groups };
  const pinned: SidebarRow[] = [];
  const rest = groups
    .map((group) => {
      const keep: SidebarRow[] = [];
      for (const row of group.rows) {
        if (pinnedIds.has(row.task.id)) pinned.push(row);
        else keep.push(row);
      }
      return { ...group, rows: keep };
    })
    .filter((group) => group.rows.length > 0);
  return {
    pinned: sortByOrder(pinned, taskOrder, (row) => row.task.id),
    rest,
  };
}

/**
 * The rail's full top-to-bottom task id order (pinned section, then each
 * visible repo group in order) "-" what Cmd/Ctrl+Shift+Up/Down cycles
 * through (see lib/sidebar-cycle.ts) and what the reveal/scroll-to-current
 * feature scrolls within.
 */
export function visibleTaskOrder(
  pinned: SidebarRow[],
  groups: SidebarGroup[],
): string[] {
  return [
    ...pinned.map((row) => row.task.id),
    ...groups.flatMap((group) => group.rows.map((row) => row.task.id)),
  ];
}
