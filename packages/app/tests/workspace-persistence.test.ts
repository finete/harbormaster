import { describe, expect, it } from "vitest";
import {
  readFocusedTaskId,
  readOpenedTaskIds,
  readWorkspaceLayout,
  removeWorkspaceLayout,
  type StorageLike,
  storeFocusedTaskId,
  storeOpenedTaskIds,
  storeWorkspaceLayout,
  WORKSPACE_LAYOUTS_KEY,
  WORKSPACE_OPENED_TASK_IDS_KEY,
  withLivePrimaryCwd,
} from "../src/renderer/src/lib/workspace-persistence";

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("opened task id persistence", () => {
  it("round-trips an empty store as an empty set", () => {
    const storage = fakeStorage();
    expect(readOpenedTaskIds(storage)).toEqual(new Set());
  });

  it("round-trips a stored set", () => {
    const storage = fakeStorage();
    storeOpenedTaskIds(storage, new Set(["t1", "t2"]));
    expect(readOpenedTaskIds(storage)).toEqual(new Set(["t1", "t2"]));
  });

  it("tolerates corrupt JSON", () => {
    const storage = fakeStorage();
    storage.setItem(WORKSPACE_OPENED_TASK_IDS_KEY, "{not json");
    expect(readOpenedTaskIds(storage)).toEqual(new Set());
  });

  it("tolerates a non-array JSON value", () => {
    const storage = fakeStorage();
    storage.setItem(WORKSPACE_OPENED_TASK_IDS_KEY, '{"a":1}');
    expect(readOpenedTaskIds(storage)).toEqual(new Set());
  });
});

describe("focused task id persistence", () => {
  it("reads back empty when never written", () => {
    const storage = fakeStorage();
    expect(readFocusedTaskId(storage)).toBe("");
  });

  it("round-trips a stored id", () => {
    const storage = fakeStorage();
    storeFocusedTaskId(storage, "t1");
    expect(readFocusedTaskId(storage)).toBe("t1");
  });
});

describe("per-task layout persistence", () => {
  const layout = {
    grid: {
      root: { type: "leaf", data: {} },
      height: 1,
      width: 1,
      orientation: "HORIZONTAL",
    },
    panels: {
      "t1-terminal-1": {
        id: "t1-terminal-1",
        contentComponent: "terminal",
        params: { cwd: "/repo", taskId: "t1", primary: true },
      },
    },
    activeGroup: "g1",
  } as unknown as Parameters<typeof storeWorkspaceLayout>[2];

  it("reads back undefined when never saved", () => {
    const storage = fakeStorage();
    expect(readWorkspaceLayout(storage, "t1")).toBeUndefined();
  });

  it("round-trips a saved layout for the right task only", () => {
    const storage = fakeStorage();
    storeWorkspaceLayout(storage, "t1", layout);
    expect(readWorkspaceLayout(storage, "t1")).toEqual(layout);
    expect(readWorkspaceLayout(storage, "t2")).toBeUndefined();
  });

  it("keeps other tasks' layouts when saving one", () => {
    const storage = fakeStorage();
    storeWorkspaceLayout(storage, "t1", layout);
    storeWorkspaceLayout(storage, "t2", layout);
    expect(readWorkspaceLayout(storage, "t1")).toEqual(layout);
    expect(readWorkspaceLayout(storage, "t2")).toEqual(layout);
  });

  it("removes a saved layout without touching others", () => {
    const storage = fakeStorage();
    storeWorkspaceLayout(storage, "t1", layout);
    storeWorkspaceLayout(storage, "t2", layout);
    removeWorkspaceLayout(storage, "t1");
    expect(readWorkspaceLayout(storage, "t1")).toBeUndefined();
    expect(readWorkspaceLayout(storage, "t2")).toEqual(layout);
  });

  it("removing a never-saved task is a no-op", () => {
    const storage = fakeStorage();
    removeWorkspaceLayout(storage, "ghost");
    expect(storage.getItem(WORKSPACE_LAYOUTS_KEY)).toBeNull();
  });

  it("tolerates corrupt JSON", () => {
    const storage = fakeStorage();
    storage.setItem(WORKSPACE_LAYOUTS_KEY, "{not json");
    expect(readWorkspaceLayout(storage, "t1")).toBeUndefined();
  });
});

describe("withLivePrimaryCwd", () => {
  it("patches the primary panel's cwd+taskId, leaving non-primary panels untouched", () => {
    const saved = {
      grid: {
        root: { type: "leaf", data: {} },
        height: 1,
        width: 1,
        orientation: "HORIZONTAL",
      },
      panels: {
        p1: {
          id: "p1",
          contentComponent: "terminal",
          params: { cwd: "/old/worktree", taskId: "t1", primary: true },
        },
        p2: {
          id: "p2",
          contentComponent: "terminal",
          params: { cwd: "/old/worktree", taskId: "t1", primary: false },
        },
      },
    } as unknown as Parameters<typeof withLivePrimaryCwd>[0];

    const patched = withLivePrimaryCwd(saved, "t1", "/new/worktree");

    expect(patched.panels.p1.params).toEqual({
      cwd: "/new/worktree",
      taskId: "t1",
      primary: true,
    });
    expect(patched.panels.p2.params).toEqual({
      cwd: "/old/worktree",
      taskId: "t1",
      primary: false,
    });
  });

  it("does not mutate the original layout object", () => {
    const saved = {
      grid: {
        root: { type: "leaf", data: {} },
        height: 1,
        width: 1,
        orientation: "HORIZONTAL",
      },
      panels: {
        p1: {
          id: "p1",
          contentComponent: "terminal",
          params: { cwd: "/old", taskId: "t1", primary: true },
        },
      },
    } as unknown as Parameters<typeof withLivePrimaryCwd>[0];

    withLivePrimaryCwd(saved, "t1", "/new");

    expect(saved.panels.p1.params).toEqual({
      cwd: "/old",
      taskId: "t1",
      primary: true,
    });
  });
});
