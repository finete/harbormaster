// The inbox's optional Priority / Other override (engines/inbox-priority.ts).
import { describe, expect, it } from "vitest";
import { applyInboxPriorityFilter } from "../src/engines/inbox-priority.js";

const items = [
  {
    id: "1",
    kind: "asked",
    source: "harbormaster",
    taskId: "t",
    priority: true,
  },
  { id: "2", kind: "rule", source: "github", priority: true },
  { id: "3", kind: "idle", priority: false, repo: "github.com/a/b" },
];

describe("applyInboxPriorityFilter", () => {
  it("keeps each producer's default without a filter", () => {
    expect(applyInboxPriorityFilter(items, undefined)).toEqual({
      priorities: [true, true, false],
    });
  });

  it("evaluates CEL over item fields (absent fields are null)", () => {
    expect(
      applyInboxPriorityFilter(
        items,
        'item.source == "github" ? false : (item.repo == "github.com/a/b" || item.priority)',
      ).priorities,
    ).toEqual([true, false, true]);
  });

  it("falls back to the default with one warning on errors or non-booleans", () => {
    const broken = applyInboxPriorityFilter(items, "item.kind");
    expect(broken.priorities).toEqual([true, true, false]);
    expect(broken.warning).toContain("must return a boolean");
    const invalid = applyInboxPriorityFilter(items, "item.(");
    expect(invalid.priorities).toEqual([true, true, false]);
    expect(invalid.warning).toMatch(/^inbox\.priorityFilter: /);
  });
});
