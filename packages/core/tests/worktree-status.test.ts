// The refresh tick's batched worktree pass (engines/worktree-status.ts):
// bounded parallelism, a per-worktree timeout that cannot stretch the
// pass, and "failed or timed out → keep the previous value".
import { describe, expect, it } from "vitest";
import type { WorktreeStatus } from "../src/contracts/model.js";
import { collectWorktreeStatus } from "../src/engines/worktree-status.js";

const now = () => new Date("2026-11-14T12:00:00.000Z");
const targets = (ids: string[]) =>
  ids.map((taskId) => ({ taskId, path: `/wt/${taskId}` }));

describe("collectWorktreeStatus", () => {
  it("answers every target, at most `concurrency` git runs at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const pass = await collectWorktreeStatus({
      targets: targets(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]),
      previous: new Map(),
      isDirty: async (path) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return path.endsWith("/b") || path.endsWith("/k");
      },
      now,
      concurrency: 6,
    });
    expect(peak).toBe(6);
    expect(pass.statuses.size).toBe(11);
    expect(pass.statuses.get("b")).toEqual({
      dirty: true,
      checkedAt: "2026-11-14T12:00:00.000Z",
    });
    expect(pass.statuses.get("a")?.dirty).toBe(false);
    expect(pass.unreadable.size).toBe(0);
  });

  it("a hung repository costs one timeout, not the tick: previous kept, else unreadable", async () => {
    const stale: WorktreeStatus = {
      dirty: true,
      checkedAt: "2026-11-14T11:59:30.000Z",
    };
    const asked: Array<{ path: string; timeoutMs: number }> = [];
    const started = Date.now();
    const pass = await collectWorktreeStatus({
      targets: targets(["slow", "slow-new", "broken", "fast"]),
      previous: new Map([
        ["slow", stale],
        ["gone", stale],
      ]),
      isDirty: (path, timeoutMs) => {
        asked.push({ path, timeoutMs });
        if (path.includes("slow")) return new Promise<boolean>(() => {});
        if (path.endsWith("broken")) {
          return Promise.reject(new Error("not a git repository"));
        }
        return Promise.resolve(true);
      },
      now,
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    // The limit is handed to git too (it kills the process).
    expect(asked.every((entry) => entry.timeoutMs === 50)).toBe(true);
    expect(pass.statuses.get("slow")).toEqual(stale);
    expect(pass.statuses.get("fast")?.dirty).toBe(true);
    // No longer a target: dropped.
    expect(pass.statuses.has("gone")).toBe(false);
    expect([...pass.unreadable].sort()).toEqual(["broken", "slow-new"]);
  });
});
