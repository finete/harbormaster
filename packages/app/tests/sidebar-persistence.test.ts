import { describe, expect, it } from "vitest";
import {
  BOARD_COLLAPSED_COLUMNS_KEY,
  BOARD_COLLAPSED_GROUPS_KEY,
  readBoardCollapsedColumns,
  readBoardCollapsedGroups,
  readCollapsedGroups,
  readCollapsedLineageParents,
  readPinnedTaskIds,
  SIDEBAR_COLLAPSED_GROUPS_KEY,
  type StorageLike,
  storeBoardCollapsedColumns,
  storeBoardCollapsedGroups,
  storeCollapsedGroups,
  storeCollapsedLineageParents,
  storePinnedTaskIds,
  togglePinned,
} from "../src/renderer/src/lib/sidebar-persistence";

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("collapsed groups persistence", () => {
  it("round-trips an empty store as an empty set", () => {
    const storage = fakeStorage();
    expect(readCollapsedGroups(storage)).toEqual(new Set());
  });

  it("round-trips a stored set", () => {
    const storage = fakeStorage();
    storeCollapsedGroups(storage, new Set(["repo-a", "repo-b"]));
    expect(readCollapsedGroups(storage)).toEqual(new Set(["repo-a", "repo-b"]));
  });

  it("tolerates corrupt JSON", () => {
    const storage = fakeStorage();
    storage.setItem("harbormaster.sidebar.collapsedGroups", "{not json");
    expect(readCollapsedGroups(storage)).toEqual(new Set());
  });

  it("tolerates a non-array JSON value", () => {
    const storage = fakeStorage();
    storage.setItem("harbormaster.sidebar.collapsedGroups", '{"a":1}');
    expect(readCollapsedGroups(storage)).toEqual(new Set());
  });
});

describe("pinned task id persistence", () => {
  it("round-trips a stored set", () => {
    const storage = fakeStorage();
    storePinnedTaskIds(storage, new Set(["t1", "t2"]));
    expect(readPinnedTaskIds(storage)).toEqual(new Set(["t1", "t2"]));
  });

  it("reads back empty when never written", () => {
    expect(readPinnedTaskIds(fakeStorage())).toEqual(new Set());
  });
});

describe("togglePinned", () => {
  it("adds an unpinned id", () => {
    expect(togglePinned(new Set(), "t1")).toEqual(new Set(["t1"]));
  });

  it("removes a pinned id", () => {
    expect(togglePinned(new Set(["t1"]), "t1")).toEqual(new Set());
  });

  it("never mutates the input set", () => {
    const current = new Set(["t1"]);
    togglePinned(current, "t2");
    expect(current).toEqual(new Set(["t1"]));
  });
});

describe("board collapsed groups persistence", () => {
  it("round-trips a stored set under its own key, independent of the rail's", () => {
    const storage = fakeStorage();
    storeCollapsedGroups(storage, new Set(["rail-group"]));
    storeBoardCollapsedGroups(
      storage,
      new Set(["backlog:scratch", "awaiting:Review::scratch"]),
    );
    expect(readBoardCollapsedGroups(storage)).toEqual(
      new Set(["backlog:scratch", "awaiting:Review::scratch"]),
    );
    expect(readCollapsedGroups(storage)).toEqual(new Set(["rail-group"]));
    expect(BOARD_COLLAPSED_GROUPS_KEY).not.toBe(SIDEBAR_COLLAPSED_GROUPS_KEY);
  });

  it("reads back empty when never written or corrupt", () => {
    const storage = fakeStorage();
    expect(readBoardCollapsedGroups(storage)).toEqual(new Set());
    storage.setItem(BOARD_COLLAPSED_GROUPS_KEY, "{nope");
    expect(readBoardCollapsedGroups(storage)).toEqual(new Set());
  });
});

describe("board collapsed columns (rail) persistence", () => {
  it("round-trips a stored set under its own key, independent of group collapse", () => {
    const storage = fakeStorage();
    storeBoardCollapsedGroups(storage, new Set(["backlog:scratch"]));
    storeBoardCollapsedColumns(storage, new Set(["backlog"]));
    expect(readBoardCollapsedColumns(storage)).toEqual(new Set(["backlog"]));
    expect(readBoardCollapsedGroups(storage)).toEqual(
      new Set(["backlog:scratch"]),
    );
    expect(BOARD_COLLAPSED_COLUMNS_KEY).not.toBe(BOARD_COLLAPSED_GROUPS_KEY);
  });

  it("reads back empty when never written or corrupt", () => {
    const storage = fakeStorage();
    expect(readBoardCollapsedColumns(storage)).toEqual(new Set());
    storage.setItem(BOARD_COLLAPSED_COLUMNS_KEY, "{nope");
    expect(readBoardCollapsedColumns(storage)).toEqual(new Set());
  });
});

describe("lineage collapsed-parents persistence", () => {
  it("round-trips a stored set, shared between board and sidebar", () => {
    const storage = fakeStorage();
    storeCollapsedLineageParents(storage, new Set(["parent-1", "parent-2"]));
    expect(readCollapsedLineageParents(storage)).toEqual(
      new Set(["parent-1", "parent-2"]),
    );
  });

  it("reads back empty when never written or corrupt", () => {
    const storage = fakeStorage();
    expect(readCollapsedLineageParents(storage)).toEqual(new Set());
    storage.setItem("harbormaster.lineage.collapsedParents", "{nope");
    expect(readCollapsedLineageParents(storage)).toEqual(new Set());
  });
});
