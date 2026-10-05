// Ported in spirit from pi-home's tests/unit/task-policy.test.ts
// (`shouldArchive`), plus the new `shouldDeleteBranch` decision this phase
// introduces for the toDone/refresh safe-cleanup path.

import { describe, expect, it } from "vitest";
import type { Task } from "../src/contracts/model.js";
import { shouldArchive, shouldDeleteBranch } from "../src/engines/cleanup.js";

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
