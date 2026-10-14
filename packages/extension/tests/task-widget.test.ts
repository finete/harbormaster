import type { Task } from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import {
  awaitingReasonLabel,
  awaitingSourceLine,
  buildTaskWidgetLines,
  prStatusColor,
  prStatusWord,
  pullRequestLine,
  type TaskWidgetTheme,
  taskSummaryLine,
} from "../src/task-widget.js";

/** Records which token wrapped which text instead of emitting real ANSI, so assertions stay readable. */
const fakeTheme: TaskWidgetTheme = {
  fg: (token, text) => `[${token}]${text}[/${token}]`,
};

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    kind: "task",
    state: "dev",
    title: "Fix the login bug",
    initialPrompt: "",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    stateChangedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("prStatusWord / prStatusColor", () => {
  it("labels a draft PR", () => {
    expect(prStatusWord({ number: 1, state: "draft" })).toBe("draft");
    expect(prStatusColor({ number: 1, state: "draft" })).toBe("accent");
  });
  it("labels an open PR with no review signal", () => {
    expect(prStatusWord({ number: 1, state: "open" })).toBe("open");
    expect(prStatusColor({ number: 1, state: "open" })).toBe("accent");
  });
  it("labels a merged PR", () => {
    expect(prStatusWord({ number: 1, state: "merged" })).toBe("merged");
    expect(prStatusColor({ number: 1, state: "merged" })).toBe("success");
  });
  it("labels a closed PR", () => {
    expect(prStatusWord({ number: 1, state: "closed" })).toBe("closed");
    expect(prStatusColor({ number: 1, state: "closed" })).toBe("error");
  });
  it("prefers changes-requested over a plain open state", () => {
    expect(
      prStatusWord({
        number: 1,
        state: "open",
        reviewDecision: "CHANGES_REQUESTED",
      }),
    ).toBe("changes requested");
    expect(
      prStatusColor({
        number: 1,
        state: "open",
        reviewDecision: "CHANGES_REQUESTED",
      }),
    ).toBe("warning");
  });
  it("treats changesRequestedOnHead the same as a CHANGES_REQUESTED decision", () => {
    expect(
      prStatusWord({ number: 1, state: "open", changesRequestedOnHead: true }),
    ).toBe("changes requested");
  });
  it("labels an approved open PR", () => {
    expect(
      prStatusWord({ number: 1, state: "open", reviewDecision: "APPROVED" }),
    ).toBe("approved");
    expect(
      prStatusColor({ number: 1, state: "open", reviewDecision: "APPROVED" }),
    ).toBe("success");
  });
  it("terminal state wins over a stale review decision", () => {
    expect(
      prStatusWord({
        number: 1,
        state: "merged",
        reviewDecision: "CHANGES_REQUESTED",
      }),
    ).toBe("merged");
  });
});

describe("awaitingReasonLabel", () => {
  it("labels review", () => {
    expect(awaitingReasonLabel({ kind: "review" })).toBe("review");
  });
  it("labels slack", () => {
    expect(awaitingReasonLabel({ kind: "slack" })).toBe("slack");
  });
  it("uses the configured deploy stage label", () => {
    expect(
      awaitingReasonLabel({
        kind: "deploy",
        stageId: "preprod",
        stageLabel: "Preprod deploy",
      }),
    ).toBe("Preprod deploy");
  });
});

describe("pullRequestLine", () => {
  it("returns undefined when the task has no PR", () => {
    expect(pullRequestLine(baseTask(), fakeTheme)).toBeUndefined();
  });

  it("wraps the PR number in an OSC-8 hyperlink when a URL is present", () => {
    const line = pullRequestLine(
      baseTask({
        pr: {
          number: 42,
          state: "open",
          url: "https://github.com/x/y/pull/42",
        },
      }),
      fakeTheme,
    );
    expect(line).toContain("\x1b]8;;https://github.com/x/y/pull/42\x1b\\");
    expect(line).toContain("PR #42");
    expect(line).toContain("\x1b]8;;\x1b\\"); // closed
  });

  it("degrades to plain text with no URL", () => {
    const line = pullRequestLine(
      baseTask({ pr: { number: 7, state: "open" } }),
      fakeTheme,
    );
    expect(line).not.toContain("\x1b]8;");
    expect(line).toContain("PR #7");
    expect(line).toContain("open");
  });

  it("prefixes the awaiting reason for a review-blocked task", () => {
    const line = pullRequestLine(
      baseTask({
        state: "awaiting",
        awaiting: { kind: "review" },
        pr: { number: 9, state: "open" },
      }),
      fakeTheme,
    );
    expect(line).toBe("[accent]review · PR #9 · open[/accent]");
  });

  it("prefixes the deploy stage label for a deploy-blocked task", () => {
    const line = pullRequestLine(
      baseTask({
        state: "awaiting",
        awaiting: {
          kind: "deploy",
          stageId: "preprod",
          stageLabel: "Preprod deploy",
        },
        pr: { number: 9, state: "merged" },
      }),
      fakeTheme,
    );
    expect(line).toBe("[success]Preprod deploy · PR #9 · merged[/success]");
  });

  it("omits the reason prefix outside the awaiting column", () => {
    const line = pullRequestLine(
      baseTask({ state: "dev", pr: { number: 3, state: "draft" } }),
      fakeTheme,
    );
    expect(line).toBe("[accent]PR #3 · draft[/accent]");
  });

  it("colors a closed PR with the error token", () => {
    const line = pullRequestLine(
      baseTask({ pr: { number: 3, state: "closed" } }),
      fakeTheme,
    );
    expect(line).toBe("[error]PR #3 · closed[/error]");
  });
});

describe("taskSummaryLine", () => {
  it("formats column · kind · title", () => {
    expect(
      taskSummaryLine(baseTask({ state: "dev", kind: "task" }), fakeTheme),
    ).toBe("[accent]Dev · task · Fix the login bug[/accent]");
  });
  it("includes the awaiting reason", () => {
    expect(
      taskSummaryLine(
        baseTask({
          state: "awaiting",
          awaiting: {
            kind: "deploy",
            stageId: "prod",
            stageLabel: "Prod deploy",
          },
        }),
        fakeTheme,
      ),
    ).toBe(
      "[accent]Awaiting · Prod deploy · task · Fix the login bug[/accent]",
    );
  });
  it("shows temp_task kind as-is", () => {
    expect(
      taskSummaryLine(baseTask({ kind: "temp_task" }), fakeTheme),
    ).toContain("temp_task · Fix the login bug");
  });
});

describe("buildTaskWidgetLines", () => {
  it("returns undefined for a missing task (clears the widget)", () => {
    expect(buildTaskWidgetLines(undefined, fakeTheme)).toBeUndefined();
  });

  it("returns a single line when there is no PR", () => {
    const lines = buildTaskWidgetLines(baseTask(), fakeTheme);
    expect(lines).toHaveLength(1);
    expect(lines?.[0]).toContain("Dev · task · Fix the login bug");
  });

  it("leads with the awaiting source, then the PR line, then the summary (title linked to the open PR)", () => {
    const lines = buildTaskWidgetLines(
      baseTask({
        state: "awaiting",
        awaiting: { kind: "review" },
        pr: {
          number: 11,
          state: "open",
          url: "https://github.com/x/y/pull/11",
        },
      }),
      fakeTheme,
    );
    expect(lines).toHaveLength(3);
    expect(lines?.[0]).toMatch(/^\[success\]Review · .*PR #11/);
    expect(lines?.[1]).toContain("PR #11");
    expect(lines?.[2]).toContain("Awaiting · review · task · ");
    expect(lines?.[2]).toContain(
      "\x1b]8;;https://github.com/x/y/pull/11\x1b\\Fix the login bug",
    );
  });

  it("names a deployment wait's merged PR and target branch", () => {
    const line = awaitingSourceLine(
      baseTask({
        state: "awaiting",
        awaiting: {
          kind: "deploy",
          stageId: "__production",
          stageLabel: "Production deploy",
        },
        pr: {
          number: 12,
          state: "merged",
          url: "https://github.com/x/y/pull/12",
          mergeCommit: { oid: "abc1234", targetBranch: "main" },
        },
      }),
      fakeTheme,
    );
    expect(line).toContain("Production deploy · ");
    expect(line).toContain("#12 → main");
  });

  it("links a Slack wait's permalink and leaves the title unlinked without an open PR", () => {
    const task = baseTask({
      state: "awaiting",
      awaiting: { kind: "slack", permalink: "https://slack.example/p1" },
    });
    expect(awaitingSourceLine(task, fakeTheme)).toContain(
      "\x1b]8;;https://slack.example/p1",
    );
    expect(awaitingSourceLine(baseTask(), fakeTheme)).toBeUndefined();
    expect(taskSummaryLine(task, fakeTheme)).not.toContain("\x1b]8;");
  });
});
