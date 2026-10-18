// Pure localStorage-shaped persistence helpers for the sidebar's saved
// group-collapse state (Orca polish item 2) and pinned task ids (item 3).
// Kept free of `window` (a `Storage`-shaped param is threaded through
// instead) so the read/write/merge logic is unit-testable under plain
// vitest (see tests/sidebar-persistence.test.ts); Sidebar.tsx is the only
// caller that ever passes the real `window.localStorage`.

/** Minimal `Storage` surface these helpers need. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SIDEBAR_COLLAPSED_GROUPS_KEY =
  "harbormaster.sidebar.collapsedGroups";
export const SIDEBAR_PINNED_TASKS_KEY = "harbormaster.sidebar.pinnedTaskIds";
/** Board group-collapse state: `boardGroupKey(column, group)` entries (see board-selection.ts). */
export const BOARD_COLLAPSED_GROUPS_KEY = "harbormaster.board.collapsedGroups";
/** Board column-collapse (slim rail) state: raw `TaskState` entries, independent of group collapse. */
export const BOARD_COLLAPSED_COLUMNS_KEY =
  "harbormaster.board.collapsedColumns";

function readStringArray(storage: StorageLike, key: string): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function writeStringArray(
  storage: StorageLike,
  key: string,
  values: Iterable<string>,
): void {
  try {
    storage.setItem(key, JSON.stringify([...values]));
  } catch {
    // Storage unavailable/full: this session just won't persist it.
  }
}

/** Restores the collapsed-group label set persisted by `storeCollapsedGroups`. */
export function readCollapsedGroups(storage: StorageLike): Set<string> {
  return new Set(readStringArray(storage, SIDEBAR_COLLAPSED_GROUPS_KEY));
}

/** Persists the full collapsed-group label set (same pattern as rail width/collapse). */
export function storeCollapsedGroups(
  storage: StorageLike,
  collapsed: ReadonlySet<string>,
): void {
  writeStringArray(storage, SIDEBAR_COLLAPSED_GROUPS_KEY, collapsed);
}

/** Restores the board's collapsed column+group key set persisted by `storeBoardCollapsedGroups`. */
export function readBoardCollapsedGroups(storage: StorageLike): Set<string> {
  return new Set(readStringArray(storage, BOARD_COLLAPSED_GROUPS_KEY));
}

/** Persists the board's full collapsed column+group key set (rail-parity pattern, separate key). */
export function storeBoardCollapsedGroups(
  storage: StorageLike,
  collapsed: ReadonlySet<string>,
): void {
  writeStringArray(storage, BOARD_COLLAPSED_GROUPS_KEY, collapsed);
}

/** Restores the board's collapsed column (rail) set persisted by `storeBoardCollapsedColumns`. */
export function readBoardCollapsedColumns(storage: StorageLike): Set<string> {
  return new Set(readStringArray(storage, BOARD_COLLAPSED_COLUMNS_KEY));
}

/** Persists the board's full collapsed-column (rail) set. */
export function storeBoardCollapsedColumns(
  storage: StorageLike,
  collapsed: ReadonlySet<string>,
): void {
  writeStringArray(storage, BOARD_COLLAPSED_COLUMNS_KEY, collapsed);
}

/** Restores the pinned task id set persisted by `storePinnedTaskIds`. */
export function readPinnedTaskIds(storage: StorageLike): Set<string> {
  return new Set(readStringArray(storage, SIDEBAR_PINNED_TASKS_KEY));
}

/** Persists the full pinned task id set. */
export function storePinnedTaskIds(
  storage: StorageLike,
  pinned: ReadonlySet<string>,
): void {
  writeStringArray(storage, SIDEBAR_PINNED_TASKS_KEY, pinned);
}

/** Toggles `taskId`'s pinned membership, returning the new set (never mutates `current`). */
export function togglePinned(
  current: ReadonlySet<string>,
  taskId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  return next;
}
