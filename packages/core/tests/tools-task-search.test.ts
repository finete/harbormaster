import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskSearchResult } from "../src/contracts/messaging.js";
import {
  deriveMessageSender,
  formatTaskSearchLine,
  formatTaskSearchText,
  resolveAttachmentPaths,
} from "../src/tools/task-search.js";

function result(overrides: Partial<TaskSearchResult> = {}): TaskSearchResult {
  return {
    id: "t-1",
    title: "Fix login",
    state: "working",
    run: "running",
    relation: "child",
    ...overrides,
  };
}

describe("formatTaskSearchLine", () => {
  it("names id, title, column, run state and relation", () => {
    expect(formatTaskSearchLine(result())).toBe(
      '"Fix login" (t-1) · Working · running · child',
    );
  });

  it("says whether a send would be direct or needs approval (nothing for the task itself)", () => {
    expect(formatTaskSearchLine(result({ send: "direct" }))).toBe(
      '"Fix login" (t-1) · Working · running · child · direct',
    );
    expect(
      formatTaskSearchLine(
        result({ relation: "none", send: "needs-approval" }),
      ),
    ).toBe(
      '"Fix login" (t-1) · Working · running · unrelated · needs approval',
    );
    expect(formatTaskSearchLine(result({ relation: "self" }))).toBe(
      '"Fix login" (t-1) · Working · running · self',
    );
  });

  it("appends repository, branch and PR when present", () => {
    expect(
      formatTaskSearchLine(
        result({
          run: "your-move",
          relation: "none",
          repositoryId: "github.com/org/repo",
          branch: "fix-login",
          prNumber: 412,
        }),
      ),
    ).toBe(
      '"Fix login" (t-1) · Working · your move · unrelated · github.com/org/repo@fix-login · PR #412',
    );
  });
});

describe("formatTaskSearchText", () => {
  it("is one line per match", () => {
    const text = formatTaskSearchText(
      [result(), result({ id: "t-2", title: "Other", state: "awaiting" })],
      "x",
    );
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("(t-2) · Awaiting");
  });

  it("explains an empty result", () => {
    expect(formatTaskSearchText([], "nothing")).toContain(
      'No tasks match "nothing"',
    );
  });
});

describe("deriveMessageSender", () => {
  it("is the task only in the pane's own task session", () => {
    expect(
      deriveMessageSender({ sessionIsTask: true, taskId: "t", cwd: "/w" }),
    ).toEqual({ kind: "task", taskId: "t" });
  });

  it("is a session sender otherwise, with the session id when known", () => {
    expect(
      deriveMessageSender({
        sessionIsTask: false,
        taskId: "t",
        cwd: "/w",
        sessionId: "s1",
      }),
    ).toEqual({ kind: "session", cwd: "/w", sessionId: "s1" });
    expect(
      deriveMessageSender({
        sessionIsTask: false,
        taskId: undefined,
        cwd: "/w",
      }),
    ).toEqual({ kind: "session", cwd: "/w" });
  });
});

describe("resolveAttachmentPaths", () => {
  it("resolves relative paths against cwd and keeps absolute ones", () => {
    const out = resolveAttachmentPaths(["shots/a.png", "/abs/b.png"], "/work");
    expect(out).toEqual([resolve("/work", "shots/a.png"), "/abs/b.png"]);
    expect(out?.every(isAbsolute)).toBe(true);
  });

  it("is undefined for nothing", () => {
    expect(resolveAttachmentPaths(undefined, "/w")).toBeUndefined();
    expect(resolveAttachmentPaths([], "/w")).toBeUndefined();
  });
});
