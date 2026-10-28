// PR-badge color mapping (components/pr-badge.ts): an OPEN PR with changes
// requested must get its own amber "changes" variant, never the closed-red
// one (the sidebar chip shows only the number, so a shared red reads as
// "closed"). Closed/merged always win over a retained review decision.
import { describe, expect, it } from "vitest";
import type { Task } from "../src/preload/api";
import { prBadgeVariant } from "../src/renderer/src/components/pr-badge";

type Pr = NonNullable<Task["pr"]>;

const pr = (overrides: Partial<Pr>): Pr =>
  ({ number: 1, state: "open", ...overrides }) as Pr;

describe("prBadgeVariant", () => {
  it("maps plain PR states to their own color", () => {
    expect(prBadgeVariant(pr({ state: "open" }))).toBe("success");
    expect(prBadgeVariant(pr({ state: "draft" }))).toBe("draft");
    expect(prBadgeVariant(pr({ state: "merged" }))).toBe("merged");
    expect(prBadgeVariant(pr({ state: "closed" }))).toBe("closed");
  });

  it("gives an OPEN changes-requested PR the amber 'changes' variant, not closed-red", () => {
    expect(
      prBadgeVariant(
        pr({ state: "open", reviewDecision: "CHANGES_REQUESTED" }),
      ),
    ).toBe("changes");
    expect(
      prBadgeVariant(
        pr({ state: "draft", reviewDecision: "CHANGES_REQUESTED" }),
      ),
    ).toBe("changes");
  });

  it("does not resurrect a closed/merged PR as 'changes' from a retained review decision", () => {
    expect(
      prBadgeVariant(
        pr({ state: "closed", reviewDecision: "CHANGES_REQUESTED" }),
      ),
    ).toBe("closed");
    expect(
      prBadgeVariant(
        pr({ state: "merged", reviewDecision: "CHANGES_REQUESTED" }),
      ),
    ).toBe("merged");
  });

  it("leaves approved / review-required PRs on their state color", () => {
    expect(
      prBadgeVariant(pr({ state: "open", reviewDecision: "APPROVED" })),
    ).toBe("success");
    expect(
      prBadgeVariant(pr({ state: "open", reviewDecision: "REVIEW_REQUIRED" })),
    ).toBe("success");
  });
});
