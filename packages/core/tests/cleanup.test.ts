// Ported in spirit from pi-home's tests/unit/task-policy.test.ts
// (`shouldArchive`), plus the new `shouldDeleteBranch` decision this phase
// introduces for the toDone/refresh safe-cleanup path.

import { describe, expect, it } from "vitest";
import type { Task } from "../src/contracts/model.js";
import {
  classifyWorktreeRemovalError,
  cleanupNeedsAttention,
  doneConfirmationLines,
  findOrphanDirs,
  isForcedCleanupDue,
  isReviewCheckoutOf,
  nextCleanupAttemptAt,
  orphanWorktreeWarning,
  shouldArchive,
  shouldDeleteBranch,
} from "../src/engines/cleanup.js";

function doneTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    kind: "task",
    state: "done",
    title: "t",
    initialPrompt: "p",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    stateChangedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("shouldArchive", () => {
  it("flags a done task 7+ days past completion", () => {
    const now = new Date("2026-01-08T00:00:01Z");
    expect(shouldArchive(doneTask(), now)).toBe(true);
  });

  it("does not flag a done task under 7 days old", () => {
    const now = new Date("2026-01-07T23:59:59Z");
    expect(shouldArchive(doneTask(), now)).toBe(false);
  });

  it("never flags a non-done task, an already-archived task, or one with no completedAt", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    expect(
      shouldArchive(doneTask({ state: "dev", completedAt: undefined }), now),
    ).toBe(false);
    expect(
      shouldArchive(doneTask({ archivedAt: "2026-01-02T00:00:00Z" }), now),
    ).toBe(false);
    expect(shouldArchive(doneTask({ completedAt: undefined }), now)).toBe(
      false,
    );
  });

  it("honors a custom retention window", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    expect(shouldArchive(doneTask(), now, 1)).toBe(true);
    expect(shouldArchive(doneTask(), now, 3)).toBe(false);
  });
});

describe("shouldDeleteBranch", () => {
  it("only deletes the branch when the PR merged", () => {
    expect(shouldDeleteBranch(undefined)).toBe(false);
    expect(shouldDeleteBranch({ number: 1, state: "open" })).toBe(false);
    expect(shouldDeleteBranch({ number: 1, state: "closed" })).toBe(false);
    expect(shouldDeleteBranch({ number: 1, state: "merged" })).toBe(true);
  });
});

describe("isReviewCheckoutOf", () => {
  const task = "/c/.harbormaster-worktrees/moshe-review-ivan-e50735";
  const at = (path: string, detached = true) => ({ path, detached });

  it("matches detached -pr<N> and -prlocal siblings of the task worktree", () => {
    expect(isReviewCheckoutOf(task, at(`${task}-pr26753`))).toBe(true);
    expect(isReviewCheckoutOf(task, at(`${task}-prlocal`))).toBe(true);
    expect(isReviewCheckoutOf(`${task}/`, at(`${task}-pr1/`))).toBe(true);
  });

  it("never matches the task itself, branches, other tasks, other dirs, or near-miss names", () => {
    expect(isReviewCheckoutOf(task, at(task))).toBe(false);
    expect(isReviewCheckoutOf(task, at(`${task}-pr26753`, false))).toBe(false);
    expect(isReviewCheckoutOf(task, at(`${task}-pr`))).toBe(false);
    expect(isReviewCheckoutOf(task, at(`${task}-pr12x`))).toBe(false);
    expect(isReviewCheckoutOf(task, at(`${task}-prefix-pr1`))).toBe(false);
    expect(isReviewCheckoutOf(task, at(`${task}2-pr1`))).toBe(false);
    expect(
      isReviewCheckoutOf(task, at("/elsewhere/moshe-review-ivan-e50735-pr1")),
    ).toBe(false);
  });
});

describe("orphan worktree scan rules", () => {
  it("findOrphanDirs keeps only directories no binding points at (trailing slashes ignored)", () => {
    expect(
      findOrphanDirs(["/r/a", "/r/b", "/r/c"], ["/r/a/", "/elsewhere/b"]),
    ).toEqual(["/r/b", "/r/c"]);
  });

  it("orphanWorktreeWarning stays quiet under both thresholds and fires on either", () => {
    const limits = { count: 3, bytes: 100 };
    const of = (n: number, size: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `/r/${i}`,
        sizeBytes: size,
      }));
    expect(orphanWorktreeWarning("/r", [], limits)).toBeUndefined();
    expect(orphanWorktreeWarning("/r", of(2, 10), limits)).toBeUndefined();
    expect(orphanWorktreeWarning("/r", of(3, 0), limits)).toMatch(
      /^3 worktrees \(0\.0 GB\) in \/r belong to no task$/,
    );
    expect(orphanWorktreeWarning("/r", of(1, 100), limits)).toMatch(
      /^1 worktree \(/,
    );
    // Unmeasured orphans still count toward the number threshold.
    expect(
      orphanWorktreeWarning("/r", [{ path: "/r/x" }], { count: 1, bytes: 1 }),
    ).toBeDefined();
  });
});

describe("doneConfirmationLines", () => {
  it("lists only what is true, in a fixed order", () => {
    expect(
      doneConfirmationLines({
        worktreePath: "/w/a",
        uncommittedChanges: 4,
        unmergedBranch: "feat",
        closesPane: true,
      }),
    ).toEqual([
      "The worktree /w/a will be removed.",
      "4 uncommitted changes will be discarded.",
      "Branch feat is not merged; the local branch will be deleted.",
      "Its terminal pane will be closed.",
    ]);
    expect(
      doneConfirmationLines({ worktreePath: "/w/a", uncommittedChanges: 1 }),
    ).toEqual([
      "The worktree /w/a will be removed.",
      "1 uncommitted change will be discarded.",
    ]);
    expect(
      doneConfirmationLines({ worktreePath: "/w/a", uncommittedChanges: 0 }),
    ).toEqual(["The worktree /w/a will be removed."]);
  });

  it('is empty for a task without a worktree (just "Mark done?")', () => {
    expect(doneConfirmationLines({})).toEqual([]);
    // No worktree: no changes or pane to speak of.
    expect(
      doneConfirmationLines({ uncommittedChanges: 3, closesPane: true }),
    ).toEqual([]);
  });
});

describe("forced cleanup backoff", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it("waits 1 min, 5 min, 30 min, then hourly", () => {
    expect(nextCleanupAttemptAt(1, now)).toBe(plus(60_000));
    expect(nextCleanupAttemptAt(2, now)).toBe(plus(5 * 60_000));
    expect(nextCleanupAttemptAt(3, now)).toBe(plus(30 * 60_000));
    expect(nextCleanupAttemptAt(4, now)).toBe(plus(60 * 60_000));
    expect(nextCleanupAttemptAt(12, now)).toBe(plus(60 * 60_000));
  });

  it("is due only for an unfinished forced cleanup past its next attempt", () => {
    const base = { requestedAt: now.toISOString(), attempts: 1 };
    expect(isForcedCleanupDue({ mode: "forced", ...base }, now)).toBe(true);
    expect(
      isForcedCleanupDue(
        { mode: "forced", ...base, nextAttemptAt: plus(1) },
        now,
      ),
    ).toBe(false);
    expect(
      isForcedCleanupDue(
        { mode: "forced", ...base, nextAttemptAt: plus(0) },
        now,
      ),
    ).toBe(true);
    expect(
      isForcedCleanupDue(
        { mode: "forced", ...base, completedAt: now.toISOString() },
        now,
      ),
    ).toBe(false);
    expect(isForcedCleanupDue({ mode: "abandoned", ...base }, now)).toBe(false);
  });

  it("needs the user after 3 failed attempts, never once completed or abandoned", () => {
    const failing = (attempts: number) =>
      doneTask({
        cleanup: {
          mode: "forced",
          requestedAt: "2026-01-01T00:00:00Z",
          attempts,
          lastError: "busy",
        },
      });
    expect(cleanupNeedsAttention(failing(2))).toBe(false);
    expect(cleanupNeedsAttention(failing(3))).toBe(true);
    const abandoned = failing(5);
    if (abandoned.cleanup) abandoned.cleanup.mode = "abandoned";
    expect(cleanupNeedsAttention(abandoned)).toBe(false);
    expect(cleanupNeedsAttention({ ...failing(5), state: "dev" })).toBe(false);
  });
});

describe("classifyWorktreeRemovalError", () => {
  it("treats ENOENT as already cleaned and a missing-metadata folder as an orphan", () => {
    expect(
      classifyWorktreeRemovalError(
        Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
      ),
    ).toBe("missing");
    expect(
      classifyWorktreeRemovalError(
        new Error("fatal: not a git repository: /r/.git/worktrees/x"),
      ),
    ).toBe("orphan");
    expect(
      classifyWorktreeRemovalError(
        new Error("fatal: '/r' is a main working tree"),
      ),
    ).toBe("other");
    expect(classifyWorktreeRemovalError("Device busy")).toBe("other");
  });
});
