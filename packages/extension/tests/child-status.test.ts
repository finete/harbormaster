import type { PresenceStatus, Task } from "@harbormaster/core";
import { describe, expect, it } from "vitest";
import {
  buildChildStatusEntry,
  categorizeChildForWidget,
  deriveChildOutcome,
  deriveChildRunState,
  formatChildrenSummaryLine,
  formatChildStatusLine,
  formatChildStatusText,
} from "../src/child-status.js";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "child-1",
    kind: "task",
    state: "dev",
    title: "Fix the flaky test",
    initialPrompt: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stateChangedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function presence(overrides: Partial<PresenceStatus> = {}): PresenceStatus {
  return { live: false, runningTurn: false, ...overrides };
}

describe("deriveChildRunState", () => {
  it("is queued when the launch is still queued", () => {
    const task = baseTask({ launch: { status: "queued", requestedAt: "t" } });
    expect(deriveChildRunState(task, presence({ live: false }))).toBe("queued");
  });

  it("is interrupted when the launch was marked interrupted, even if presence looks live", () => {
    const task = baseTask({
      launch: { status: "interrupted", requestedAt: "t" },
    });
    expect(
      deriveChildRunState(task, presence({ live: true, runningTurn: true })),
    ).toBe("interrupted");
  });

  it("is working when live and a turn is running", () => {
    const task = baseTask({ launch: { status: "started", requestedAt: "t" } });
    expect(
      deriveChildRunState(task, presence({ live: true, runningTurn: true })),
    ).toBe("working");
  });

  it('is "your move" when live but idle', () => {
    const task = baseTask({ launch: { status: "started", requestedAt: "t" } });
    expect(
      deriveChildRunState(task, presence({ live: true, runningTurn: false })),
    ).toBe("your move");
  });

  it("is not running when there is no live presence", () => {
    const task = baseTask({ launch: { status: "started", requestedAt: "t" } });
    expect(deriveChildRunState(task, presence({ live: false }))).toBe(
      "not running",
    );
  });
});

describe("deriveChildOutcome", () => {
  it("reads the live outcome while attached", () => {
    const status = presence({
      live: true,
      record: {
        taskId: "child-1",
        sessionPath: "/s",
        pid: 1,
        mode: "interactive",
        startedAt: "t",
        heartbeatAt: "t",
        outcome: { status: "done", note: "shipped it", at: "t" },
      },
    });
    expect(deriveChildOutcome(status)).toEqual({
      status: "done",
      note: "shipped it",
    });
  });

  it("reads the ended outcome once the process is gone", () => {
    const status = presence({
      live: false,
      record: {
        taskId: "child-1",
        sessionPath: "/s",
        pid: 1,
        mode: "headless",
        startedAt: "t",
        heartbeatAt: "t",
        ended: { status: "blocked", note: "needs creds", at: "t" },
      },
    });
    expect(deriveChildOutcome(status)).toEqual({
      status: "blocked",
      note: "needs creds",
    });
  });

  it("is undefined with no presence record at all", () => {
    expect(deriveChildOutcome(presence())).toBeUndefined();
  });
});

describe("buildChildStatusEntry / formatChildStatusLine", () => {
  it("includes the awaiting reason, PR, run state, and outcome", () => {
    const task = baseTask({
      state: "awaiting",
      awaiting: { kind: "review" },
      pr: { number: 7, state: "open", url: "https://pr/7" },
      launch: { status: "started", requestedAt: "t" },
    });
    const status = presence({
      live: true,
      runningTurn: false,
      record: {
        taskId: "child-1",
        sessionPath: "/s",
        pid: 1,
        mode: "interactive",
        startedAt: "t",
        heartbeatAt: "t",
        outcome: { status: "done", note: "opened the PR", at: "t" },
      },
    });
    const entry = buildChildStatusEntry(task, status);
    expect(entry).toEqual({
      id: "child-1",
      title: "Fix the flaky test",
      state: "awaiting",
      awaiting: { kind: "review", label: "review" },
      pr: { number: 7, state: "open", url: "https://pr/7" },
      runState: "your move",
      outcome: { status: "done", note: "opened the PR" },
    });
    const line = formatChildStatusLine(entry);
    expect(line).toBe(
      '"Fix the flaky test" (child-1) · Awaiting (awaiting review) · your move · PR #7 open https://pr/7 · outcome: done — opened the PR',
    );
  });

  it("formats a plain queued child with no PR/outcome", () => {
    const task = baseTask({
      launch: { status: "queued", requestedAt: "t" },
    });
    const entry = buildChildStatusEntry(task, presence());
    expect(formatChildStatusLine(entry)).toBe(
      '"Fix the flaky test" (child-1) · Dev · queued',
    );
  });
});

describe("formatChildStatusText", () => {
  it('returns "No child tasks." for an empty list', () => {
    expect(formatChildStatusText([])).toBe("No child tasks.");
  });

  it("joins multiple entries with newlines", () => {
    const task = baseTask({ launch: { status: "queued", requestedAt: "t" } });
    const entry = buildChildStatusEntry(task, presence());
    expect(formatChildStatusText([entry, entry])).toBe(
      `${formatChildStatusLine(entry)}\n${formatChildStatusLine(entry)}`,
    );
  });
});

describe("categorizeChildForWidget", () => {
  it("categorizes a done task as done regardless of presence", () => {
    const task = baseTask({ state: "done" });
    expect(
      categorizeChildForWidget(
        task,
        presence({ live: true, runningTurn: true }),
      ),
    ).toBe("done");
  });

  it("otherwise falls back to the run state", () => {
    const task = baseTask({ launch: { status: "queued", requestedAt: "t" } });
    expect(categorizeChildForWidget(task, presence())).toBe("queued");
  });
});

describe("formatChildrenSummaryLine", () => {
  it("returns undefined with no children", () => {
    expect(formatChildrenSummaryLine([])).toBeUndefined();
  });

  it("counts and orders categories pi-home style", () => {
    expect(
      formatChildrenSummaryLine([
        "done",
        "working",
        "working",
        "your move",
        "queued",
      ]),
    ).toBe("children: 2 working · 1 your move · 1 queued · 1 done");
  });
});
