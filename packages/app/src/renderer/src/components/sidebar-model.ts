// Pure view-model logic for the workspace sidebar (Sidebar.tsx): repository
// grouping, running-first ordering, search filtering, board-position chip
// labels, PR links, and compact relative times. Kept free of React and of
// `window` so it is unit-testable under plain vitest (see
// packages/app/tests/sidebar-model.test.ts).
import type {
  BoardColumn,
  PresenceBadge,
  Task,
  TaskState,
} from "../../../preload/api";

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
 * Every non-archived, *opened* task on the board, in board (column, then
 * group) order. The rail lists open task workspaces, cmux-style, not the
 * full board inventory (`openedTaskIds` is App's `openedTaskIds` state) —
 * the Board stays the full inventory, see App.tsx / docs/design-decisions.md.
 */
export function sidebarRows(
  columns: BoardColumn[],
  presence: Record<string, PresenceBadge | undefined>,
  openedTaskIds: ReadonlySet<string>,
): SidebarRow[] {
  return columns.flatMap((column) =>
    column.groups.flatMap((group) =>
      group.tasks
        .filter((task) => !task.archivedAt && openedTaskIds.has(task.id))
        .map((task) => ({
          task,
          state: column.state,
          presence: presence[task.id],
        })),
    ),
  );
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

function activityRank(row: SidebarRow): number {
  if (row.presence?.runningTurn) return 0;
  if (row.presence?.live) return 1;
  return 2;
}

/**
 * Groups rows by short repository name (alphabetical, "scratch" last). Within
 * a group, running tasks come first, then live-but-idle, then everything
 * else — each tier keeping its original (board) order.
 */
export function groupRows(rows: SidebarRow[]): SidebarGroup[] {
  const byLabel = new Map<string, SidebarRow[]>();
  for (const row of rows) {
    const label = repoLabel(row.task);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(row);
    else byLabel.set(label, [row]);
  }
  const labels = [...byLabel.keys()].sort((a, b) => {
    if (a === SCRATCH_GROUP) return b === SCRATCH_GROUP ? 0 : 1;
    if (b === SCRATCH_GROUP) return -1;
    return a.localeCompare(b);
  });
  return labels.map((label) => {
    const bucket = byLabel.get(label) ?? [];
    const ordered = bucket
      .map((row, index) => ({ row, index }))
      .sort(
        (a, b) =>
          activityRank(a.row) - activityRank(b.row) || a.index - b.index,
      )
      .map(({ row }) => row);
    return { label, rows: ordered };
  });
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
  return (
    (row.presence?.live ? row.presence.heartbeatAt : undefined) ??
    row.task.updatedAt
  );
}

/** Compact age: "now" (<1m), "3m", "2h", "5d", "4w", "7mo", "2y". */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
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
