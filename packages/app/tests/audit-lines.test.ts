import { describe, expect, it } from "vitest";
import type { AuditActionEntry, AuditEntry } from "../src/preload/api";
import {
  auditActionVerb,
  auditActionWhy,
  auditRuleLabel,
  describeAuditAction,
  historyLines,
  humanize,
  lastRuleAction,
} from "../src/renderer/src/lib/audit-lines";

const now = Date.parse("2026-11-11T12:00:00.000Z");
const move: AuditActionEntry = {
  kind: "action",
  at: "2026-11-11T11:56:00.000Z",
  taskId: "t",
  ruleId: "review-changes-requested",
  ruleLabel: "Needs changes",
  file: "rules.yaml",
  line: 12,
  eventId: "e1",
  eventType: "github.pr.reviewDecisionChanged",
  action: "move",
  with: { to: "dev" },
  from: { state: "awaiting", awaitingKind: "review" },
  outcome: "applied",
};

describe("audit lines", () => {
  it("says from → to, when, and the rule's tag; the technical why apart", () => {
    expect(describeAuditAction(move, now)).toBe(
      "Review → Dev · 4m ago · Needs changes",
    );
    expect(auditActionWhy(move)).toBe(
      "github.pr.reviewDecisionChanged · rule review-changes-requested (rules.yaml:12)",
    );
    expect(
      describeAuditAction({ ...move, at: "2026-11-11T11:59:50.000Z" }, now),
    ).toBe("Review → Dev · just now · Needs changes");
  });

  it("falls back for older entries: no `from`, no label", () => {
    const { from: _from, ruleLabel: _label, ...old } = move;
    expect(auditActionVerb(old)).toBe("Moved to Dev");
    expect(auditRuleLabel(old)).toBe("Review changes requested");
    expect(humanize("deploy_land.now")).toBe("Deploy land now");
  });

  it("names awaiting columns by kind and words other outcomes", () => {
    expect(
      auditActionVerb({
        ...move,
        from: { state: "dev" },
        with: { to: "await", kind: "deploy" },
      }),
    ).toBe("Dev → Deploy");
    expect(auditActionVerb({ ...move, with: { to: "await" } })).toBe(
      "Review → Review",
    );
    expect(
      auditActionVerb({
        ...move,
        with: { to: "done" },
        outcome: "stayed",
        detail: "dirty worktree",
      }),
    ).toBe("Tried Done, stayed (dirty worktree)");
    expect(auditActionVerb({ ...move, action: "inbox", with: {} })).toBe(
      "Added an inbox item",
    );
    expect(
      auditActionVerb({
        ...move,
        action: "message",
        outcome: "failed",
        detail: "x",
      }),
    ).toBe("Failed: sent a message (x)");
  });

  it("finds the newest action; history hides raw events unless asked", () => {
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
        file: "rules.yaml",
        line: 3,
      },
    ];
    expect(lastRuleAction(entries)).toBe(move);
    expect(lastRuleAction([])).toBeUndefined();
    expect(historyLines(entries, now)).toEqual([
      expect.objectContaining({
        kind: "warning",
        text: "Warning: boom",
        why: "rule r (rules.yaml:3)",
        when: "3m ago",
      }),
      expect.objectContaining({
        kind: "action",
        text: "Review → Dev",
        label: "Needs changes",
        why: auditActionWhy(move),
        when: "4m ago",
      }),
    ]);
    expect(
      historyLines(entries, now, { includeEvents: true, limit: 2 }).map(
        (line) => line.kind,
      ),
    ).toEqual(["warning", "action"]);
    expect(
      historyLines(entries, now, { includeEvents: true }).map(
        (line) => line.text,
      ),
    ).toContain("github.pr.reviewDecisionChanged");
  });
});
