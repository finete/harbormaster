// Chip derivation for task messaging (lib/task-messaging-chips.ts): the
// four chips, the waiting-on-parent state with its deadline evaluated on
// the caller's clock, and the amber "your move" suppression that follows it.
import { describe, expect, it } from "vitest";
import type { TaskMessagingState } from "../src/preload/api";
import {
  deriveMessagingChips,
  isWaitingOnParentActive,
  loopCapLabel,
} from "../src/renderer/src/lib/task-messaging-chips";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function state(
  overrides: Partial<TaskMessagingState> = {},
): TaskMessagingState {
  return { taskId: "t", ...overrides };
}

describe("deriveMessagingChips", () => {
  it("is empty without a state", () => {
    expect(deriveMessagingChips(undefined, NOW)).toEqual({
      approvalsWaiting: 0,
      childQuestionsWaiting: 0,
      suppressAttention: false,
    });
  });

  it("carries approval, child-question and loop-cap signals", () => {
    const chips = deriveMessagingChips(
      state({
        approvalsWaiting: 2,
        childQuestionsWaiting: 1,
        loopCapReached: { otherTaskId: "o", count: 8, cap: 8 },
      }),
      NOW,
    );
    expect(chips.approvalsWaiting).toBe(2);
    expect(chips.childQuestionsWaiting).toBe(1);
    expect(chips.loopCapReached).toEqual({
      otherTaskId: "o",
      count: 8,
      cap: 8,
    });
    // None of these mute the amber state by themselves.
    expect(chips.suppressAttention).toBe(false);
    expect(chips.waitingOnParent).toBeUndefined();
  });

  it("waiting on parent shows the question and suppresses amber while its deadline is in the future", () => {
    const chips = deriveMessagingChips(
      state({
        waitingOnParent: {
          messageId: "m",
          question: "Which DB?",
          deliveredAt: iso(NOW - 60_000),
          expiresAt: iso(NOW + 60_000),
        },
      }),
      NOW,
    );
    expect(chips.waitingOnParent).toEqual({ question: "Which DB?" });
    expect(chips.suppressAttention).toBe(true);
  });

  it("stays active while the question is not yet delivered (no deadline)", () => {
    const chips = deriveMessagingChips(
      state({ waitingOnParent: { messageId: "m", question: "q" } }),
      NOW,
    );
    expect(chips.waitingOnParent).toBeDefined();
    expect(chips.suppressAttention).toBe(true);
  });

  it("amber returns by itself once the deadline passes on the caller's clock", () => {
    const waiting = state({
      waitingOnParent: {
        messageId: "m",
        question: "q",
        expiresAt: iso(NOW + 1_000),
      },
    });
    expect(deriveMessagingChips(waiting, NOW).suppressAttention).toBe(true);
    const later = deriveMessagingChips(waiting, NOW + 1_000);
    expect(later.suppressAttention).toBe(false);
    expect(later.waitingOnParent).toBeUndefined();
    expect(deriveMessagingChips(waiting, NOW + 60_000).suppressAttention).toBe(
      false,
    );
  });

  it("other chips survive the waiting state's expiry", () => {
    const chips = deriveMessagingChips(
      state({
        approvalsWaiting: 1,
        waitingOnParent: {
          messageId: "m",
          question: "q",
          expiresAt: iso(NOW - 1),
        },
      }),
      NOW,
    );
    expect(chips.approvalsWaiting).toBe(1);
    expect(chips.suppressAttention).toBe(false);
  });
});

describe("isWaitingOnParentActive", () => {
  it("treats an unparsable deadline as expired (never mute attention forever)", () => {
    expect(
      isWaitingOnParentActive(
        { messageId: "m", question: "q", expiresAt: "garbage" },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("loopCapLabel", () => {
  it("names the counts and the user hand-off", () => {
    expect(loopCapLabel({ count: 8, cap: 8 })).toBe(
      "message cap reached (8/8): ask the user",
    );
  });
});
