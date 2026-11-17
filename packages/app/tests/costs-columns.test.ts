import { describe, expect, it } from "vitest";
import {
  COSTS_COLUMNS_KEY,
  COSTS_GROUP_COLUMNS,
  COSTS_TABLE_COLUMNS,
  clampColumnWidth,
  MIN_COLUMN_WIDTH,
  migrateColumnWidths,
  readColumnWidths,
  resetColumn,
  resizeColumn,
  resolveColumnWidths,
  type StorageLike,
  storeColumnWidths,
} from "../src/renderer/src/lib/costs-columns";

function fakeStorage(initial?: string): StorageLike & { raw(): string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: (key) => (key === COSTS_COLUMNS_KEY ? value : null),
    setItem: (key, next) => {
      if (key === COSTS_COLUMNS_KEY) value = next;
    },
    raw: () => value,
  };
}

describe("costs column widths", () => {
  it("defaults when storage is empty: shares of the container that fill it", () => {
    const widths = readColumnWidths(fakeStorage());
    expect(widths).toEqual({});
    const resolved = resolveColumnWidths(COSTS_TABLE_COLUMNS, widths, 1000);
    expect(resolved).toEqual([320, 180, 80, 180, 120, 120]);
    expect(resolved.reduce((a, b) => a + b, 0)).toBe(1000);
    // Group-by table: the key column shares the Task width.
    const group = resolveColumnWidths(COSTS_GROUP_COLUMNS, widths, 1000);
    expect(group[0]).toBe(320);
    expect(group.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("round-trips through storage as versioned JSON", () => {
    const storage = fakeStorage();
    storeColumnWidths(storage, { task: 460, models: 120 });
    expect(JSON.parse(storage.raw() ?? "")).toEqual({
      v: 1,
      widths: { task: 460, models: 120 },
    });
    expect(readColumnWidths(storage)).toEqual({ task: 460, models: 120 });
  });

  it("set widths win; the table overflows rather than squashing", () => {
    const resolved = resolveColumnWidths(
      COSTS_TABLE_COLUMNS,
      { task: 460 },
      1000,
    );
    expect(resolved).toEqual([460, 180, 80, 180, 120, 120]);
    // A narrowed column leaves space for the last (handle-less) column.
    expect(
      resolveColumnWidths(COSTS_TABLE_COLUMNS, { task: 240 }, 1000),
    ).toEqual([240, 180, 80, 180, 120, 200]);
  });

  it("clamps to the minimum width", () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(120.6)).toBe(121);
    expect(resizeColumn({}, "repo", 200, -500)).toEqual({
      repo: MIN_COLUMN_WIDTH,
    });
    expect(resizeColumn({ task: 300 }, "repo", 200, 120)).toEqual({
      task: 300,
      repo: 320,
    });
    expect(
      readColumnWidths(
        fakeStorage(JSON.stringify({ v: 1, widths: { task: 3 } })),
      ),
    ).toEqual({ task: MIN_COLUMN_WIDTH });
  });

  it("falls back to defaults on corrupt or unknown data", () => {
    expect(readColumnWidths(fakeStorage("{not json"))).toEqual({});
    expect(readColumnWidths(fakeStorage("[1,2]"))).toEqual({});
    expect(readColumnWidths(fakeStorage('"x"'))).toEqual({});
    expect(migrateColumnWidths({ v: 2, widths: { task: 400 } })).toEqual({});
    expect(migrateColumnWidths({ widths: { task: 400 } })).toEqual({});
    expect(migrateColumnWidths({ v: 1, widths: null })).toEqual({});
    expect(
      migrateColumnWidths({
        v: 1,
        widths: { task: "400", bogus: 300, repo: 250, models: Infinity },
      }),
    ).toEqual({ repo: 250 });
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readColumnWidths(throwing)).toEqual({});
    expect(() => storeColumnWidths(throwing, { task: 300 })).not.toThrow();
  });

  it("resets one column without touching the others", () => {
    const widths = { task: 460, repo: 120 };
    const reset = resetColumn(widths, "task");
    expect(reset).toEqual({ repo: 120 });
    expect(widths).toEqual({ task: 460, repo: 120 });
    expect(resolveColumnWidths(COSTS_TABLE_COLUMNS, reset, 1000)[0]).toBe(320);
  });
});
