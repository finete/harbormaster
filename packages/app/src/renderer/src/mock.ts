// ---------------------------------------------------------------------------
// PLACEHOLDER DATA — stands in for @harbormaster/core's command API.
//
// Once packages/core exposes its board command API (commands in, state
// events out — see /docs/design-decisions.md and /AGENTS.md), this file goes
// away and the board subscribes to real task/column state instead. Nothing
// here should be treated as a stable shape; it exists only to prove the
// kanban + dnd-kit + badge UI stack.
// ---------------------------------------------------------------------------

export type ColumnId = "backlog" | "dev" | "awaiting" | "done";

export interface PrBadge {
  number: number;
  state: "open" | "merged" | "draft";
}

export interface TaskCard {
  id: string;
  title: string;
  repo: string;
  branch: string;
  pr?: PrBadge;
  running?: boolean;
}

export interface MockColumn {
  id: ColumnId;
  title: string;
  cardIds: string[];
}

export const mockCards: Record<string, TaskCard> = {
  "t-101": {
    id: "t-101",
    title: "Port board mover timers",
    repo: "harbormaster",
    branch: "backlog/mover-timers",
  },
  "t-102": {
    id: "t-102",
    title: "Design takeover-offer dialog",
    repo: "harbormaster",
    branch: "backlog/takeover-dialog",
  },
  "t-201": {
    id: "t-201",
    title: "Wire dockview panel restore",
    repo: "harbormaster",
    branch: "dev/dockview-restore",
    running: true,
  },
  "t-202": {
    id: "t-202",
    title: "Pi harness adapter interface",
    repo: "harbormaster",
    branch: "dev/harness-adapter",
    pr: { number: 42, state: "draft" },
  },
  "t-301": {
    id: "t-301",
    title: "Presence spinner polish",
    repo: "harbormaster",
    branch: "awaiting/presence-spinner",
    pr: { number: 39, state: "open" },
  },
  "t-401": {
    id: "t-401",
    title: "Extract core command API",
    repo: "harbormaster",
    branch: "done/command-api",
    pr: { number: 31, state: "merged" },
  },
  "t-402": {
    id: "t-402",
    title: "Freeze TUI board against core",
    repo: "harbormaster",
    branch: "done/freeze-tui",
    pr: { number: 28, state: "merged" },
  },
};

export const mockColumns: MockColumn[] = [
  { id: "backlog", title: "Backlog", cardIds: ["t-101", "t-102"] },
  { id: "dev", title: "Dev", cardIds: ["t-201", "t-202"] },
  { id: "awaiting", title: "Awaiting", cardIds: ["t-301"] },
  { id: "done", title: "Done", cardIds: ["t-401", "t-402"] },
];

/** Which column a task currently sits in — used by the sidebar's status dot. */
export function columnOf(taskId: string): ColumnId {
  for (const column of mockColumns) {
    if (column.cardIds.includes(taskId)) return column.id;
  }
  throw new Error(`unknown task id: ${taskId}`);
}

/** Flat task order (board column order) — drives the sidebar task list. */
export const taskOrder: string[] = mockColumns.flatMap(
  (column) => column.cardIds,
);
