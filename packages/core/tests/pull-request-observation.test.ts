// Ported in spirit from pi-home's tests/unit/default-addons.test.ts
// (the observePullRequest matrix exercised through githubReviewMover), but
// targeting the pure engine directly since Harbormaster's AwaitingKind is
// simpler than pi-home's AwaitingContext.

import { describe, expect, it } from "vitest";
import type { TaskPullRequest } from "../src/contracts/model.js";
import { observePullRequest } from "../src/engines/pull-request-observation.js";

const pr = (overrides: Partial<TaskPullRequest> = {}): TaskPullRequest => ({
  number: 1,
  state: "open",
  ...overrides,
});

describe("observePullRequest", () => {
  it("moves dev work into review on a requested or submitted review", () => {
    expect(
      observePullRequest("dev", undefined, pr({ reviewRequested: true })),
    ).toBe("enter_review");
    expect(
      observePullRequest("dev", undefined, pr({ reviewSubmitted: true })),
    ).toBe("enter_review");
    expect(observePullRequest("dev", undefined, pr())).toBe("stay");
  });

  it("returns review work to dev on changes-requested or human feedback on the current head", () => {
    const review = { kind: "review" as const };
    expect(
      observePullRequest(
        "awaiting",
        review,
        pr({
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedOnHead: true,
        }),
      ),
    ).toBe("return_to_dev");
    expect(
      observePullRequest(
        "awaiting",
        review,
        pr({
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedOnHead: false,
        }),
      ),
    ).toBe("stay");
    expect(
      observePullRequest("awaiting", review, pr({ humanFeedbackOnHead: true })),
    ).toBe("return_to_dev");
  });

  it("keeps dev work in dev instead of re-entering review for the same feedback", () => {
    expect(
      observePullRequest(
        "dev",
        undefined,
        pr({
          reviewDecision: "CHANGES_REQUESTED",
          changesRequestedOnHead: true,
          reviewSubmitted: true,
        }),
      ),
    ).toBe("stay");
    expect(
      observePullRequest(
        "dev",
        undefined,
        pr({ reviewSubmitted: true, humanFeedbackOnHead: true }),
      ),
    ).toBe("stay");
  });

  it("reports merged regardless of column, except Slack/deploy sources which never react", () => {
    expect(observePullRequest("dev", undefined, pr({ state: "merged" }))).toBe(
      "merged",
    );
    expect(
      observePullRequest(
        "awaiting",
        { kind: "review" },
        pr({ state: "merged" }),
      ),
    ).toBe("merged");
    expect(
      observePullRequest(
        "awaiting",
        { kind: "slack" },
        pr({ state: "merged" }),
      ),
    ).toBe("stay");
    expect(
      observePullRequest(
        "awaiting",
        { kind: "deploy", stageId: "pre", stageLabel: "Preprod" },
        pr({ state: "merged" }),
      ),
    ).toBe("stay");
  });

  it("returns a draft PR from review to dev, but otherwise leaves draft tasks alone", () => {
    expect(
      observePullRequest(
        "awaiting",
        { kind: "review" },
        pr({ state: "draft" }),
      ),
    ).toBe("return_to_dev");
    expect(observePullRequest("dev", undefined, pr({ state: "draft" }))).toBe(
      "stay",
    );
  });

  it("ignores backlog and done tasks entirely", () => {
    expect(
      observePullRequest("backlog", undefined, pr({ reviewRequested: true })),
    ).toBe("stay");
    expect(
      observePullRequest("done", undefined, pr({ reviewRequested: true })),
    ).toBe("stay");
  });
});
