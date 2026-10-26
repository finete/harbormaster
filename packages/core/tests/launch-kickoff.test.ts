// Unit tests for the pure kickoff-contract engine (see
// /docs/design-decisions.md "Launching tasks from an agent" "Kickoff contract").

import { describe, expect, it } from "vitest";
import { buildLaunchKickoffPrompt } from "../src/engines/launch-kickoff.js";

describe("buildLaunchKickoffPrompt", () => {
  it("lists all six points for a repository-backed standalone task", () => {
    const text = buildLaunchKickoffPrompt({ hasRepository: true });
    expect(text).toContain("1. Work only inside this task's worktree.");
    expect(text).toContain(
      "2. Run the repository's relevant checks/tests for your change.",
    );
    expect(text).toContain(
      "3. Commit with a clear message and push the branch.",
    );
    expect(text).toMatch(/4\. Open a DRAFT pull request/);
    expect(text).toMatch(/5\. If you are genuinely blocked/);
    expect(text).toMatch(
      /6\. As your FINAL action call `harbormaster_report_status`/,
    );
    expect(text).not.toContain("Launched as a subtask of");
    // A standalone task has no parent to ask: the original wording, unchanged.
    expect(text).not.toContain("harbormaster_send_to_task");
    expect(text).toContain(
      `5. If you are genuinely blocked or need a decision, stop and ask -- the user sees your task as "your move". Otherwise do not stop to ask; make reasonable decisions and note them.`,
    );
  });

  it("skips the commit/push/PR points for a repository-less task, renumbering the rest", () => {
    const text = buildLaunchKickoffPrompt({ hasRepository: false });
    expect(text).toContain("1. Work only inside this task's worktree.");
    expect(text).toContain(
      "2. Run the repository's relevant checks/tests for your change.",
    );
    expect(text).not.toMatch(/Commit with a clear message/);
    expect(text).not.toMatch(/DRAFT pull request/);
    expect(text).toMatch(/3\. If you are genuinely blocked/);
    expect(text).toMatch(
      /4\. As your FINAL action call `harbormaster_report_status`/,
    );
  });

  it("names the launching task for a child", () => {
    const text = buildLaunchKickoffPrompt({
      hasRepository: true,
      parent: { title: "Fix the thing", id: "parent-1" },
    });
    expect(text).toContain(
      "Launched as a subtask of: Fix the thing (parent-1)",
    );
  });

  it("lets a child ask its parent by id, but sends product/scope decisions and an unavailable parent to the user", () => {
    const text = buildLaunchKickoffPrompt({
      hasRepository: true,
      parent: { title: "Fix the thing", id: "parent-1" },
    });
    expect(text).toMatch(/5\. If you are genuinely blocked/);
    expect(text).toContain(
      "ask your parent task (parent-1) with `harbormaster_send_to_task` and then end your turn",
    );
    expect(text).toMatch(
      /Product or scope decisions, or a parent that is unavailable/,
    );
    expect(text).toContain(`the user sees your task as "your move"`);
    // Numbering and the final-report point are unchanged.
    expect(text).toMatch(
      /6\. As your FINAL action call `harbormaster_report_status`/,
    );
  });

  it("states the stacked-branch dependency when based on a parent's branch", () => {
    const text = buildLaunchKickoffPrompt({
      hasRepository: true,
      dependencyBranch: "feature/parent-branch",
    });
    expect(text).toMatch(/based on "feature\/parent-branch"/);
    expect(text).toMatch(/state that dependency/);
  });
});
