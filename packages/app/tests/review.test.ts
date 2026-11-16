// Review button enablement, default target and the "Ready to review" hint
// candidates (lib/review.ts, docs/plannotator.md decisions 1/4/5).
import { describe, expect, it } from "vitest";
import type { PresenceBadge, ReviewSupport, Task } from "../src/preload/api";
import {
  defaultReviewTarget,
  isAgentIdle,
  REVIEW_SETUP_HINT,
  reviewDisabledReason,
  reviewHintCandidates,
  taskHarness,
} from "../src/renderer/src/lib/review";

const support: ReviewSupport = {
  checkedAt: "2026-11-14T00:00:00Z",
  harnesses: [
    { harness: "pi", state: "ready", pieces: [] },
    { harness: "claude-code", state: "outdated", pieces: [] },
    { harness: "custom", state: "unsupported", pieces: [] },
  ],
};

function task(partial: Partial<Task>): Task {
  return { id: "t", state: "working", title: "t", ...partial } as Task;
}

const idle: PresenceBadge = {
  live: true,
  runningTurn: false,
  corroboration: "record",
  status: { state: "idle" },
};

describe("reviewDisabledReason", () => {
  it("is enabled for a ready harness at rest", () => {
    expect(
      reviewDisabledReason({ support, harness: "pi", runningTurn: false }),
    ).toBeUndefined();
  });
  it("points at setup when Plannotator is not ready", () => {
    expect(
      reviewDisabledReason({
        support,
        harness: "claude-code",
        runningTurn: false,
      }),
    ).toBe(REVIEW_SETUP_HINT);
  });
  it("is disabled for a harness without a review command or unlisted", () => {
    expect(
      reviewDisabledReason({ support, harness: "custom", runningTurn: false }),
    ).toMatch(/cannot start/);
    expect(
      reviewDisabledReason({ support, harness: "other", runningTurn: false }),
    ).toMatch(/cannot start/);
  });
  it("is disabled mid-turn and before support is known", () => {
    expect(
      reviewDisabledReason({ support, harness: "pi", runningTurn: true }),
    ).toMatch(/working/);
    expect(
      reviewDisabledReason({
        support: null,
        harness: "pi",
        runningTurn: false,
      }),
    ).toMatch(/Checking/);
  });
});

describe("defaultReviewTarget / taskHarness", () => {
  it("defaults to the PR when the task has one", () => {
    expect(defaultReviewTarget(task({}))).toBe("local");
    expect(
      defaultReviewTarget(
        task({
          pr: {
            number: 3,
            url: "https://github.com/o/r/pull/3",
            state: "open",
          },
        }),
      ),
    ).toBe("pr");
  });
  it("treats a task without a recorded agent as Pi", () => {
    expect(taskHarness({})).toBe("pi");
    expect(taskHarness({ harness: "claude-code" })).toBe("claude-code");
  });
});

describe("reviewHintCandidates", () => {
  it("keeps only Dev tasks whose agent is idle", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b" }),
      task({ id: "c", state: "awaiting" }),
      task({ id: "d" }),
      task({ id: "e" }),
    ];
    expect(
      reviewHintCandidates(tasks, {
        a: idle,
        b: { ...idle, runningTurn: true },
        c: idle,
        e: { ...idle, status: { state: "blocked" } },
      }),
    ).toEqual(["a"]);
  });
  it("needs a live session", () => {
    expect(isAgentIdle(undefined)).toBe(false);
    expect(isAgentIdle({ ...idle, live: false })).toBe(false);
    expect(isAgentIdle({ ...idle, status: undefined })).toBe(true);
  });
});
