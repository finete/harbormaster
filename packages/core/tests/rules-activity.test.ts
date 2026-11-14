// The per-rule activity fold (engines/rules/activity.ts) the Rules page
// shows (docs/rules-page.md decision 13): latest action per (file, rule)
// within the window, plus the count.

import { describe, expect, it } from "vitest";
import type { AuditActionEntry, AuditEntry } from "../src/contracts/rules.js";
import {
  foldRuleActivity,
  RULE_ACTIVITY_WINDOW_DAYS,
  ruleActivityKey,
  ruleActivitySince,
} from "../src/engines/rules/activity.js";

const NOW = new Date("2026-03-31T12:00:00.000Z");

function action(overrides: Partial<AuditActionEntry>): AuditActionEntry {
  return {
    kind: "action",
    at: "2026-03-30T12:00:00.000Z",
    ruleId: "r1",
    file: "rules.yaml",
    line: 2,
    eventId: "e1",
    eventType: "github.pr.stateChanged",
    action: "move",
    outcome: "applied",
    ...overrides,
  };
}

describe("foldRuleActivity", () => {
  it("keeps the latest action per rule and counts every action in the window", () => {
    const entries: AuditEntry[] = [
      action({ at: "2026-03-29T10:00:00.000Z", taskId: "t1" }),
      {
        kind: "event",
        at: "2026-03-30T00:00:00.000Z",
        event: {
          specversion: "1.0",
          id: "e9",
          source: "github",
          type: "github.pr.stateChanged",
          time: "2026-03-30T00:00:00.000Z",
        },
      },
      action({
        at: "2026-03-30T10:00:00.000Z",
        taskId: "t2",
        outcome: "superseded",
        detail: "an earlier rule moved it",
      }),
      {
        kind: "warning",
        at: "2026-03-31T00:00:00.000Z",
        message: "boom",
        ruleId: "r1",
        file: "rules.yaml",
      },
    ];
    const folded = foldRuleActivity(entries, NOW, 30);
    expect([...folded.keys()]).toEqual([ruleActivityKey("rules.yaml", "r1")]);
    expect(folded.get(ruleActivityKey("rules.yaml", "r1"))).toEqual({
      lastAt: "2026-03-30T10:00:00.000Z",
      lastOutcome: "superseded",
      lastDetail: "an earlier rule moved it",
      lastTaskId: "t2",
      count: 2,
    });
  });

  it("reports a failed last outcome and drops detail/task when the latest has none", () => {
    const folded = foldRuleActivity(
      [
        action({ at: "2026-03-30T09:00:00.000Z", taskId: "t1", detail: "x" }),
        action({ at: "2026-03-30T11:00:00.000Z", outcome: "failed" }),
      ],
      NOW,
      30,
    );
    expect(folded.get(ruleActivityKey("rules.yaml", "r1"))).toEqual({
      lastAt: "2026-03-30T11:00:00.000Z",
      lastOutcome: "failed",
      count: 2,
    });
  });

  it("an out-of-order older entry counts but does not replace the latest", () => {
    const folded = foldRuleActivity(
      [
        action({ at: "2026-03-30T11:00:00.000Z", outcome: "stayed" }),
        action({ at: "2026-03-30T09:00:00.000Z", outcome: "applied" }),
      ],
      NOW,
      30,
    );
    expect(folded.get(ruleActivityKey("rules.yaml", "r1"))).toMatchObject({
      lastOutcome: "stayed",
      count: 2,
    });
  });

  it("separates the same rule id in different files (overrides)", () => {
    const folded = foldRuleActivity(
      [
        action({ file: "rules.yaml" }),
        action({ file: "repos/github.com/acme/api.yaml", outcome: "skipped" }),
      ],
      NOW,
      30,
    );
    expect(folded.get(ruleActivityKey("rules.yaml", "r1"))?.lastOutcome).toBe(
      "applied",
    );
    expect(
      folded.get(ruleActivityKey("repos/github.com/acme/api.yaml", "r1"))
        ?.lastOutcome,
    ).toBe("skipped");
  });

  it("the window includes its start edge and excludes anything older or in the future", () => {
    const start = ruleActivitySince(NOW, 30);
    expect(start).toBe("2026-03-01T12:00:00.000Z");
    const folded = foldRuleActivity(
      [
        action({ ruleId: "edge", at: start }),
        action({ ruleId: "old", at: "2026-03-01T11:59:59.999Z" }),
        action({ ruleId: "future", at: "2026-03-31T12:00:00.001Z" }),
        action({ ruleId: "garbage", at: "not a time" }),
        action({ ruleId: "now", at: NOW.toISOString() }),
      ],
      NOW,
      30,
    );
    expect([...folded.keys()].sort()).toEqual(
      [
        ruleActivityKey("rules.yaml", "edge"),
        ruleActivityKey("rules.yaml", "now"),
      ].sort(),
    );
  });

  it("an unknown rule (no actions) has no entry; the window is 30 days", () => {
    expect(foldRuleActivity([], NOW, 30).size).toBe(0);
    expect(
      foldRuleActivity([action({})], NOW, 30).get(
        ruleActivityKey("rules.yaml", "nope"),
      ),
    ).toBeUndefined();
    expect(RULE_ACTIVITY_WINDOW_DAYS).toBe(30);
  });
});
