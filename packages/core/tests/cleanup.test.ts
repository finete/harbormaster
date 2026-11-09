// Ported in spirit from pi-home's tests/unit/task-policy.test.ts
// (`shouldArchive`), plus the new `shouldDeleteBranch` decision this phase
// introduces for the toDone/refresh safe-cleanup path.

import { describe, expect, it } from "vitest";
import type { Task } from "../src/contracts/model.js";
import {
  findOrphanDirs,
  isReviewCheckoutOf,
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
