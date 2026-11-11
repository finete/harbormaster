import { describe, expect, it } from "vitest";
import type { AuditActionEntry, AuditEntry } from "../src/preload/api";
import {
  auditActionVerb,
  describeAuditAction,
  historyLines,
  lastRuleAction,
} from "../src/renderer/src/lib/audit-lines";

const now = Date.parse("2026-11-11T12:00:00.000Z");
const move: AuditActionEntry = {
  kind: "action",
  at: "2026-11-11T11:56:00.000Z",
  taskId: "t",
  ruleId: "review-changes-requested",
  file: "rules.yaml",
  line: 12,
  eventId: "e1",
  eventType: "github.pr.reviewDecisionChanged",
  action: "move",
  with: { to: "dev" },
  outcome: "applied",
};

describe("audit lines", () => {
  it("says what moved where, when and why", () => {
    expect(describeAuditAction(move, now)).toBe(
      "moved to Dev 4m ago because github.pr.reviewDecisionChanged matched rule review-changes-requested (rules.yaml:12)",
    );
    expect(
      auditActionVerb({ ...move, with: { to: "await", kind: "deploy" } }),
    ).toBe("moved to Awaiting: deploy");
    expect(
      auditActionVerb({
        ...move,
        with: { to: "done" },
        outcome: "stayed",
        detail: "dirty worktree",
      }),
    ).toBe("tried to move to Done, stayed (dirty worktree)");
    expect(auditActionVerb({ ...move, action: "inbox", with: {} })).toBe(
      "added an inbox item",
    );
    expect(
      describeAuditAction({ ...move, at: "2026-11-11T11:59:50.000Z" }, now),
    ).toMatch(/^moved to Dev just now because/);
  });

  it("finds the newest action and lists history newest first", () => {
    const entries: AuditEntry[] = [
      {
        kind: "event",
        at: "2026-11-11T11:55:00.000Z",
        event: {
          specversion: "1.0",
          id: "e1",
          source: "github",
          type: "github.pr.reviewDecisionChanged",
          time: "x",
        },
      },
      move,
      {
        kind: "warning",
        at: "2026-11-11T11:57:00.000Z",
        message: "boom",
        ruleId: "r",
      },
    ];
    expect(lastRuleAction(entries)).toBe(move);
    expect(lastRuleAction([])).toBeUndefined();
    expect(
      historyLines(entries, now, 2).map((line) => [line.kind, line.text]),
    ).toEqual([
      ["warning", "warning in rule r: boom"],
      ["action", describeAuditAction(move, now)],
    ]);
  });
});
