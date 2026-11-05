// Warm closed-tab session cache (main/warm-sessions.ts): bounded LRU of
// detached task primaries, never evicting a mid-turn agent, and ending
// sessions whose task left the active set (Done/deleted) so they can't
// block worktree cleanup.
import { describe, expect, it } from "vitest";
import { WarmSessionCache } from "../src/main/warm-sessions";

function harness(capacity = 2) {
  const warm = new Set<string>();
  const working = new Set<string>();
  const disposed: string[] = [];
  // Session "s-x" is the primary of task "t-x".
  const cache = new WarmSessionCache(
    {
      isWarm: (id) => warm.has(id),
      taskIdOf: (id) => id.replace(/^s-/, "t-"),
      isWorking: (taskId) => working.has(taskId),
      dispose: (id) => {
        warm.delete(id);
        disposed.push(id);
      },
    },
    capacity,
  );
  const close = (id: string) => {
    warm.add(id);
    cache.add(id);
  };
  return { cache, warm, working, disposed, close };
}

describe("WarmSessionCache", () => {
  it("keeps the most recently closed sessions and disposes the oldest past capacity", () => {
    const h = harness(2);
    h.close("s-a");
    h.close("s-b");
    h.close("s-c");
    expect(h.disposed).toEqual(["s-a"]);
    expect(h.cache.ids()).toEqual(["s-b", "s-c"]);
  });

  it("never evicts a mid-turn agent; trims it once it goes idle", () => {
    const h = harness(1);
    h.working.add("t-a");
    h.close("s-a");
    h.working.add("t-b");
    h.close("s-b");
    expect(h.disposed).toEqual([]);
    expect(h.cache.ids()).toEqual(["s-a", "s-b"]);

    h.working.delete("t-a");
    h.cache.reconcile(new Set(["t-a", "t-b"]));
    expect(h.disposed).toEqual(["s-a"]);
  });

  it("evicts an idle session ahead of an older working one", () => {
    const h = harness(1);
    h.working.add("t-a");
    h.close("s-a");
    h.close("s-b");
    expect(h.disposed).toEqual(["s-b"]);
    expect(h.cache.ids()).toEqual(["s-a"]);
  });

  it("a reopened (forgotten) or dead session no longer counts toward capacity", () => {
    const h = harness(2);
    h.close("s-a");
    h.close("s-b");
    h.cache.forget("s-a"); // reopened with a pane
    h.warm.delete("s-b"); // its pi exited on its own
    h.close("s-c");
    h.close("s-d");
    expect(h.disposed).toEqual([]);
    expect(h.cache.ids()).toEqual(["s-c", "s-d"]);
  });

  it("reconcile disposes sessions whose task is no longer active (Done/deleted)", () => {
    const h = harness(5);
    h.close("s-a");
    h.close("s-b");
    h.cache.reconcile(new Set(["t-b"]));
    expect(h.disposed).toEqual(["s-a"]);
    expect(h.cache.ids()).toEqual(["s-b"]);
  });

  it("disposeForTask ends that task's warm session immediately", () => {
    const h = harness(5);
    h.close("s-a");
    h.close("s-b");
    h.cache.disposeForTask("t-a");
    expect(h.disposed).toEqual(["s-a"]);
    expect(h.cache.ids()).toEqual(["s-b"]);
  });
});
