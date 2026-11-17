// Resizable, persisted column widths for the Costs page tables
// (CostsView.tsx: `costs-table` and the group-by `costs-groups`). Pure and
// window-free (a `StorageLike` is threaded through, same pattern as
// lib/sidebar-persistence.ts) so tests/costs-columns.test.ts covers it under
// plain vitest.
//
// Model: every column has a default share of the table's container width;
// a column the user dragged keeps an explicit px width (the only thing
// stored). The last column has no handle and absorbs any leftover space so
// an untouched table always fills its container; if the columns add up to
// more than the container, the table scrolls horizontally instead of
// squashing. localStorage lives in Electron's user-data dir, so the widths
// survive restarts and app updates.

/** Minimal `Storage` surface these helpers need. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const COSTS_COLUMNS_KEY = "harbormaster.costs.columns";
/** Shape version of the stored JSON (`{ v, widths }`). */
export const COSTS_COLUMNS_VERSION = 1;
/** No column can be dragged (or restored) narrower than this, in px. */
export const MIN_COLUMN_WIDTH = 48;
/** Container width assumed before the real one has been measured. */
export const FALLBACK_CONTAINER_WIDTH = 960;

export type CostsColumnKey =
  | "task"
  | "repo"
  | "harness"
  | "models"
  | "tokens"
  | "cost"
  | "groupTasks"
  | "groupTurns";

const COLUMN_KEYS: ReadonlySet<string> = new Set<CostsColumnKey>([
  "task",
  "repo",
  "harness",
  "models",
  "tokens",
  "cost",
  "groupTasks",
  "groupTurns",
]);

/** Default share of the container width per column. */
export const DEFAULT_COLUMN_FRACTIONS: Readonly<
  Record<CostsColumnKey, number>
> = {
  task: 0.32,
  repo: 0.18,
  harness: 0.08,
  models: 0.18,
  tokens: 0.12,
  cost: 0.12,
  groupTasks: 0.14,
  groupTurns: 0.14,
};

/** Task table columns, left to right. */
export const COSTS_TABLE_COLUMNS: readonly CostsColumnKey[] = [
  "task",
  "repo",
  "harness",
  "models",
  "tokens",
  "cost",
];

/** Group-by table columns: the group key shares the Task width. */
export const COSTS_GROUP_COLUMNS: readonly CostsColumnKey[] = [
  "task",
  "groupTasks",
  "groupTurns",
  "tokens",
  "cost",
];

/** User-set px widths; a missing key means "use the default". */
export type ColumnWidths = Partial<Record<CostsColumnKey, number>>;

export function isCostsColumnKey(value: string): value is CostsColumnKey {
  return COLUMN_KEYS.has(value);
}

export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH;
  return Math.max(MIN_COLUMN_WIDTH, Math.round(width));
}

/** The default px width of `key` in a container `containerWidth` px wide. */
export function defaultColumnWidth(
  key: CostsColumnKey,
  containerWidth: number,
): number {
  return clampColumnWidth(DEFAULT_COLUMN_FRACTIONS[key] * containerWidth);
}

/**
 * Effective px widths for `columns` (same order). Untouched columns get their
 * default share; the last column also takes any space the others leave.
 */
export function resolveColumnWidths(
  columns: readonly CostsColumnKey[],
  widths: ColumnWidths,
  containerWidth: number,
): number[] {
  const container =
    Number.isFinite(containerWidth) && containerWidth > 0
      ? containerWidth
      : FALLBACK_CONTAINER_WIDTH;
  const resolved = columns.map(
    (key) => widths[key] ?? defaultColumnWidth(key, container),
  );
  const lastIndex = resolved.length - 1;
  const lastKey = columns[lastIndex];
  const lastWidth = resolved[lastIndex];
  if (
    lastKey !== undefined &&
    lastWidth !== undefined &&
    widths[lastKey] === undefined
  ) {
    const others = resolved
      .slice(0, lastIndex)
      .reduce((sum, width) => sum + width, 0);
    resolved[lastIndex] = Math.max(lastWidth, Math.floor(container - others));
  }
  return resolved;
}

/** `key` dragged from `startWidth` by `delta` px (clamped to the minimum). */
export function resizeColumn(
  widths: ColumnWidths,
  key: CostsColumnKey,
  startWidth: number,
  delta: number,
): ColumnWidths {
  return { ...widths, [key]: clampColumnWidth(startWidth + delta) };
}

/** Back to `key`'s default width (double-click on its handle). */
export function resetColumn(
  widths: ColumnWidths,
  key: CostsColumnKey,
): ColumnWidths {
  const next = { ...widths };
  delete next[key];
  return next;
}

/** Stored JSON of any known version → current widths; anything else → defaults. */
export function migrateColumnWidths(stored: unknown): ColumnWidths {
  if (typeof stored !== "object" || stored === null) return {};
  const record = stored as { v?: unknown; widths?: unknown };
  if (record.v !== COSTS_COLUMNS_VERSION) return {};
  const raw = record.widths;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const widths: ColumnWidths = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isCostsColumnKey(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    widths[key] = clampColumnWidth(value);
  }
  return widths;
}

/** Restores the widths saved by `storeColumnWidths` (defaults on corrupt data). */
export function readColumnWidths(storage: StorageLike): ColumnWidths {
  try {
    const raw = storage.getItem(COSTS_COLUMNS_KEY);
    if (!raw) return {};
    return migrateColumnWidths(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Persists the user-set widths as `{ v: 1, widths }`. */
export function storeColumnWidths(
  storage: StorageLike,
  widths: ColumnWidths,
): void {
  try {
    storage.setItem(
      COSTS_COLUMNS_KEY,
      JSON.stringify({ v: COSTS_COLUMNS_VERSION, widths }),
    );
  } catch {
    // Storage unavailable/full: this session just won't persist it.
  }
}
